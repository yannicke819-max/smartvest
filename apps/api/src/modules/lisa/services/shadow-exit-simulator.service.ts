/**
 * PR6.5 — Shadow exit-simulator worker (Phase 3.4 étape 5).
 *
 * Cron 5min : pour chaque shadow signal ACCEPT non encore exit-simulated et
 * dont l'âge dépasse 5 min (donne du temps pour 1+ candle 1m), replay la
 * state machine BLOC 4 (TP/SL/trailing 20/50) sur les candles intraday
 * fetchées depuis EodhdIntradayService (equity) ou BinanceMarketService (crypto).
 *
 * Update :
 *   simulated_exit_price, simulated_exit_at, simulated_exit_reason,
 *   simulated_pnl_pct, simulated_slippage_pct
 *
 * Permet le calcul win-rate dans gainers_shadow_daily_report et la
 * validation Phase 4 des critères ADR-005 §5 Step 9.
 */

import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { SupabaseService } from '../../supabase/supabase.service';
import {
  applyTick,
  PositionSnapshot,
} from '../../gainers-scanner/bloc4/trailing-engine';
import { PositionState, ExitReason } from '../../gainers-scanner/domain/gainers-enums';
import { EodhdIntradayService } from './eodhd-intraday.service';
import { IntradayProviderRouter } from './intraday-provider-router.service';
import { BinanceMarketService } from './binance-market.service';
import { ensureEodhdSuffix } from './eodhd-symbol.util';
import { isLikelyOtcForeignOrdinaryUS } from './otc-prefilter.helper';

interface ShadowSignalRow {
  id: string;
  symbol: string;
  exchange: string;
  asset_class: 'equity' | 'crypto';
  entry_price: number;
  entry_path_eff: number;
  tp_price: number;
  sl_price: number;
  created_at: string;
}

interface SimResult {
  exitPrice: number;
  exitAt: string;
  exitReason: string;
  pnlPct: number;
  slippagePct: number | null;
}

const MIN_AGE_MIN_BEFORE_REPLAY = 5;
const MAX_HOLD_HOURS = 3; // ADR-005 §2.4 time-stop

@Injectable()
export class ShadowExitSimulatorService {
  private readonly logger = new Logger(ShadowExitSimulatorService.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly eodhd: EodhdIntradayService,
    private readonly binance: BinanceMarketService,
    // PR #353 — Router intraday : dual-call EODHD + TD si flag ON.
    // Conserve eodhd pour helpers (summarize, getCandlesViaTicks).
    private readonly intradayRouter: IntradayProviderRouter,
  ) {}

  /** Cron 5 min — replay state machine pour signals ACCEPT non encore simulés. */
  @Cron('*/5 * * * *')
  async runExitSimulator(): Promise<void> {
    try {
      await this.runInner();
    } catch (e) {
      this.logger.error(`[exit-sim] cron failed: ${String(e).slice(0, 200)}`);
    }
  }

  private async runInner(): Promise<void> {
    const minAgeMs = MIN_AGE_MIN_BEFORE_REPLAY * 60_000;
    const cutoff = new Date(Date.now() - minAgeMs).toISOString();

    const { data, error } = await this.supabase
      .getClient()
      .from('gainers_v1_shadow_signals')
      .select('id, symbol, exchange, asset_class, entry_price, entry_path_eff, tp_price, sl_price, created_at')
      .eq('decision', 'ACCEPT')
      .is('simulated_exit_at', null)
      .not('entry_price', 'is', null)
      .lte('created_at', cutoff)
      .order('created_at', { ascending: true })
      .limit(50);

    if (error || !data || data.length === 0) return;

    let processed = 0;
    let succeeded = 0;
    for (const r of data as ShadowSignalRow[]) {
      processed++;
      try {
        const sim = await this.simulateOne(r);
        if (!sim) continue;
        const { error: upErr } = await this.supabase
          .getClient()
          .from('gainers_v1_shadow_signals')
          .update({
            simulated_exit_price: sim.exitPrice,
            simulated_exit_at: sim.exitAt,
            simulated_exit_reason: sim.exitReason,
            simulated_pnl_pct: sim.pnlPct,
            simulated_slippage_pct: sim.slippagePct,
          })
          .eq('id', r.id);
        if (upErr) this.logger.warn(`[exit-sim] update ${r.id} failed: ${upErr.message}`);
        else succeeded++;
      } catch (e) {
        this.logger.warn(`[exit-sim] sim ${r.symbol} (${r.id}) failed: ${String(e).slice(0, 80)}`);
      }
    }
    this.logger.log(`[exit-sim] processed ${processed} signals, ${succeeded} simulated`);
  }

  /**
   * Simule un signal : fetch candles 1m depuis entry_at, replay BLOC 4 state
   * machine. Retourne null si pas assez de candles ou MAX_HOLD_HOURS atteint
   * sans hit (TIME_LIMIT).
   */
  private async simulateOne(row: ShadowSignalRow): Promise<SimResult | null> {
    const entryTime = new Date(row.created_at).getTime();
    const ageMin = (Date.now() - entryTime) / 60_000;
    const replayCount = Math.min(60 * MAX_HOLD_HOURS, Math.ceil(ageMin));
    if (replayCount < 5) return null;

    const candles = await this.fetchCandles(row, replayCount);
    if (!candles || candles.length === 0) return null;

    // Build PositionSnapshot from BLOC 4 contract
    const initial: PositionSnapshot = {
      state: PositionState.OPEN,
      entryPrice: row.entry_price,
      pathEff: row.entry_path_eff,
      tpPrice: row.tp_price,
      initialSlPrice: row.sl_price,
      currentStopPrice: row.sl_price,
      mfePrice: row.entry_price,
    };

    let snap = { ...initial };
    let exitTickIdx = -1;
    let exitReason: ExitReason | null = null;

    for (let i = 0; i < candles.length; i++) {
      const c = candles[i];
      // Use close as the tick price (simplification). Could test high/low for
      // intra-candle stop hits — kept simple for PR6.5.
      const r = applyTick({ position: snap, currentPrice: c.close });
      snap = {
        ...snap,
        state: r.newState,
        currentStopPrice: r.newStopPrice,
        mfePrice: r.newMfePrice,
      };
      if (r.exitReason) {
        exitReason = r.exitReason;
        exitTickIdx = i;
        break;
      }
    }

    // Aucun exit dans la fenêtre : check TIME_LIMIT
    if (exitTickIdx === -1) {
      if (ageMin >= MAX_HOLD_HOURS * 60) {
        exitReason = ExitReason.TIME_LIMIT;
        exitTickIdx = candles.length - 1;
      } else {
        return null; // pas encore time-limit, attendre prochain cron
      }
    }

    const exitCandle = candles[exitTickIdx];
    const exitTime = new Date(entryTime + (exitTickIdx + 1) * 60_000).toISOString();
    const exitPrice = exitCandle.close;
    const pnlPct = (exitPrice - row.entry_price) / row.entry_price;
    const theoretical =
      exitReason === ExitReason.TP_FULL ? row.tp_price :
      exitReason === ExitReason.SL ? row.sl_price :
      snap.currentStopPrice;
    const slippagePct = theoretical !== null
      ? (exitPrice - theoretical) / row.entry_price
      : null;

    return {
      exitPrice,
      exitAt: exitTime,
      exitReason: String(exitReason),
      pnlPct,
      slippagePct,
    };
  }

  /** Fetch intraday 1m candles depuis le ticker (EODHD ou Binance). */
  private async fetchCandles(
    row: ShadowSignalRow,
    count: number,
  ): Promise<Array<{ close: number }> | null> {
    if (row.asset_class === 'crypto') {
      const binanceSymbol = this.toBinanceSymbol(row.symbol);
      if (!binanceSymbol) return null;
      const candles = await this.binance.getKlines(binanceSymbol, '1m', count);
      return candles ? candles.map((c) => ({ close: c.close })) : null;
    }
    // Hotfix EODHD bypass — applique suffix exchange avant getCandles. Avant
    // ce fix, des rows legacy (pré-PR #234) avec symbol RAW (ex: "005940",
    // "NOCIL") tombaient en HTTP 404 silencieusement → coverage='none'.
    const eodhdTicker = ensureEodhdSuffix(row.symbol, row.exchange);
    // PR #298 BUG 2 FIX — Skip OTC Foreign Ordinary US (jamais d'intraday
    // dispo). Évite EODHD call inutile dans le replay shadow-exit.
    if (isLikelyOtcForeignOrdinaryUS(eodhdTicker)) {
      return null;
    }
    // PR #353 — router dual-call (TD + EODHD) si éligible, sinon EODHD-only.
    const series = await this.intradayRouter.getCandles(eodhdTicker, '1m', count, {
      calledBy: 'shadow_exit_sim',
    });
    return series ? series.candles.map((c) => ({ close: c.close })) : null;
  }

  private toBinanceSymbol(eodhdSymbol: string): string | null {
    const m = eodhdSymbol.match(/^([A-Z0-9]+)-USD\.CC$/);
    return m ? `${m[1]}USDT` : null;
  }
}
