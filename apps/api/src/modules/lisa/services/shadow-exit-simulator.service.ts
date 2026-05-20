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

/** Shadow A/B — résultat de la variante entrée pullback (cf. migration 0150). */
interface VariantResult {
  entryPrice: number;
  entryOffsetMin: number;
  exitPrice: number;
  exitAt: string;
  exitReason: string;
  pnlPct: number;
  slippagePct: number | null;
  /** Migration 0151 — issues simulées par couple (tp,sl) sur la même entrée pullback. */
  exitGrid: ExitGridEntry[];
}

/** Migration 0151 — une issue d'exit pour un couple (tp_pct, sl_pct) donné. */
interface ExitGridEntry {
  tp_pct: number;
  sl_pct: number;
  pnl_pct: number;
  exit_reason: 'TP_FULL' | 'SL' | 'TIME_LIMIT';
  exit_offset_min: number;
}

// Migration 0151 — grille d'exits asymétriques testée en forward. Couples
// (TP, SL) issus du backtest crypto où l'espérance monte avec la largeur du TP.
const EXIT_GRID: ReadonlyArray<{ tp: number; sl: number }> = [
  { tp: 0.03, sl: 0.025 },
  { tp: 0.05, sl: 0.025 },
  { tp: 0.08, sl: 0.025 },
  { tp: 0.12, sl: 0.03 },
  { tp: 0.20, sl: 0.03 },
];

const MIN_AGE_MIN_BEFORE_REPLAY = 5;
const MAX_HOLD_HOURS = 3; // ADR-005 §2.4 time-stop

@Injectable()
export class ShadowExitSimulatorService {
  private readonly logger = new Logger(ShadowExitSimulatorService.name);

  // Shadow A/B variante entrée pullback (migration 0150). Params env, defaults
  // issus du backtest 48h crypto (pullback 1.5% + SL 2.5% + TP 3% → +0.47% net).
  private readonly variantEnabled = process.env.SHADOW_ENTRY_VARIANT_ENABLED !== 'false';
  private readonly variantPullbackPct = Number(process.env.SHADOW_VARIANT_PULLBACK_PCT ?? '0.015');
  private readonly variantWindowMin = Number(process.env.SHADOW_VARIANT_WINDOW_MIN ?? '30');
  private readonly variantSlPct = Number(process.env.SHADOW_VARIANT_SL_PCT ?? '0.025');
  private readonly variantTpPct = Number(process.env.SHADOW_VARIANT_TP_PCT ?? '0.03');

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
    // Shadow A/B variante pullback — indépendant du live (try/catch séparé pour
    // qu'un échec variante n'affecte jamais la simulation live).
    if (this.variantEnabled) {
      try {
        await this.runVariantInner();
      } catch (e) {
        this.logger.error(`[exit-sim:variant] cron failed: ${String(e).slice(0, 200)}`);
      }
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

  /**
   * Shadow A/B (migration 0150) — pour chaque signal ACCEPT dont la variante
   * n'est pas encore tranchée, simule une entrée pullback + SL élargi.
   */
  private async runVariantInner(): Promise<void> {
    const cutoff = new Date(Date.now() - MIN_AGE_MIN_BEFORE_REPLAY * 60_000).toISOString();
    const { data, error } = await this.supabase
      .getClient()
      .from('gainers_v1_shadow_signals')
      .select('id, symbol, exchange, asset_class, entry_price, entry_path_eff, tp_price, sl_price, created_at')
      .eq('decision', 'ACCEPT')
      .not('entry_price', 'is', null)
      .is('variant_exit_at', null)
      .is('variant_no_entry', null)
      .lte('created_at', cutoff)
      .order('created_at', { ascending: true })
      .limit(50);

    if (error || !data || data.length === 0) return;

    const params = {
      pullback_pct: this.variantPullbackPct,
      window_min: this.variantWindowMin,
      sl_pct: this.variantSlPct,
      tp_pct: this.variantTpPct,
    };
    let resolved = 0;
    let noEntry = 0;
    for (const r of data as ShadowSignalRow[]) {
      try {
        const v = await this.simulateVariant(r);
        if (v === 'pending' || v === null) continue;
        const update = v === 'no_entry'
          ? { variant_no_entry: true, variant_params: params }
          : {
              variant_entry_price: v.entryPrice,
              variant_entry_offset_min: v.entryOffsetMin,
              variant_no_entry: false,
              variant_exit_price: v.exitPrice,
              variant_exit_at: v.exitAt,
              variant_exit_reason: v.exitReason,
              variant_pnl_pct: v.pnlPct,
              variant_slippage_pct: v.slippagePct,
              variant_params: params,
              variant_exit_grid: v.exitGrid,
            };
        const { error: upErr } = await this.supabase
          .getClient()
          .from('gainers_v1_shadow_signals')
          .update(update)
          .eq('id', r.id);
        if (upErr) this.logger.warn(`[exit-sim:variant] update ${r.id} failed: ${upErr.message}`);
        else if (v === 'no_entry') noEntry++;
        else resolved++;
      } catch (e) {
        this.logger.warn(`[exit-sim:variant] ${r.symbol} (${r.id}) failed: ${String(e).slice(0, 80)}`);
      }
    }
    this.logger.log(`[exit-sim:variant] resolved ${resolved}, no_entry ${noEntry}`);
  }

  /**
   * Simule la variante pullback sur un signal. Retourne :
   *   - 'no_entry' : fenêtre écoulée sans pullback (la variante n'aurait pas tradé)
   *   - 'pending'  : pullback touché mais exit non encore résolu (réessayer)
   *   - null       : pas assez de données / trop jeune pour conclure
   *   - VariantResult : entrée+exit résolus
   */
  private async simulateVariant(row: ShadowSignalRow): Promise<VariantResult | 'no_entry' | 'pending' | null> {
    const entryTimeMs = new Date(row.created_at).getTime();
    const ageMin = (Date.now() - entryTimeMs) / 60_000;
    // Fenêtre pullback + horizon de hold complet.
    const maxCandles = this.variantWindowMin + 60 * MAX_HOLD_HOURS;
    const replayCount = Math.min(maxCandles, Math.ceil(ageMin));
    if (replayCount < 5) return null;

    const candles = await this.fetchCandles(row, replayCount);
    if (!candles || candles.length === 0) return null;

    // 1. Cherche le 1er pullback sous entry_price*(1-pullback_pct) dans la fenêtre.
    const pullbackTrigger = row.entry_price * (1 - this.variantPullbackPct);
    const windowEnd = Math.min(this.variantWindowMin, candles.length);
    let entryIdx = -1;
    for (let i = 0; i < windowEnd; i++) {
      if (candles[i].close <= pullbackTrigger) {
        entryIdx = i;
        break;
      }
    }

    if (entryIdx === -1) {
      // Pas de pullback observé. On ne peut conclure 'no_entry' que si la fenêtre
      // est entièrement écoulée (sinon il peut encore arriver).
      if (ageMin >= this.variantWindowMin) return 'no_entry';
      return null;
    }

    // 2. Entrée à ce close, SL élargi + TP relatifs à l'entrée variante.
    const variantEntry = candles[entryIdx].close;
    const initialSl = variantEntry * (1 - this.variantSlPct);
    let snap: PositionSnapshot = {
      state: PositionState.OPEN,
      entryPrice: variantEntry,
      pathEff: row.entry_path_eff,
      tpPrice: variantEntry * (1 + this.variantTpPct),
      initialSlPrice: initialSl,
      currentStopPrice: initialSl,
      mfePrice: variantEntry,
    };

    // 3. Replay BLOC4 (identique au live) sur les candles post-entrée.
    let exitIdx = -1;
    let exitReason: ExitReason | null = null;
    for (let i = entryIdx + 1; i < candles.length; i++) {
      const r = applyTick({ position: snap, currentPrice: candles[i].close });
      snap = { ...snap, state: r.newState, currentStopPrice: r.newStopPrice, mfePrice: r.newMfePrice };
      if (r.exitReason) {
        exitReason = r.exitReason;
        exitIdx = i;
        break;
      }
    }

    if (exitIdx === -1) {
      const variantEntryTimeMs = entryTimeMs + (entryIdx + 1) * 60_000;
      const holdMin = (Date.now() - variantEntryTimeMs) / 60_000;
      if (holdMin >= MAX_HOLD_HOURS * 60) {
        exitReason = ExitReason.TIME_LIMIT;
        exitIdx = candles.length - 1;
      } else {
        return 'pending';
      }
    }

    const exitPrice = candles[exitIdx].close;
    const exitAt = new Date(entryTimeMs + (exitIdx + 1) * 60_000).toISOString();
    const pnlPct = (exitPrice - variantEntry) / variantEntry;
    const theoretical =
      exitReason === ExitReason.TP_FULL ? snap.tpPrice :
      exitReason === ExitReason.SL ? initialSl :
      snap.currentStopPrice;
    const slippagePct = theoretical !== null ? (exitPrice - theoretical) / variantEntry : null;

    // Migration 0151 — grille d'exits asymétriques sur la MÊME entrée pullback.
    const exitGrid = this.computeExitGrid(candles, entryIdx, variantEntry);

    return {
      entryPrice: variantEntry,
      entryOffsetMin: entryIdx + 1,
      exitPrice,
      exitAt,
      exitReason: String(exitReason),
      pnlPct,
      slippagePct,
      exitGrid,
    };
  }

  /**
   * Migration 0151 — pour chaque couple (tp, sl) de la grille, course TP/SL
   * close-based sur les candles post-entrée. TIME_LIMIT = sortie au dernier
   * close si ni TP ni SL touché. Sert à mesurer forward l'edge des exits larges.
   */
  private computeExitGrid(
    candles: Array<{ close: number }>,
    entryIdx: number,
    entry: number,
  ): ExitGridEntry[] {
    return EXIT_GRID.map(({ tp, sl }) => {
      const tpPx = entry * (1 + tp);
      const slPx = entry * (1 - sl);
      for (let i = entryIdx + 1; i < candles.length; i++) {
        const px = candles[i].close;
        // SL prioritaire (protège le capital), comme la state machine BLOC4.
        if (px <= slPx) {
          return { tp_pct: tp, sl_pct: sl, pnl_pct: -sl, exit_reason: 'SL' as const, exit_offset_min: i + 1 };
        }
        if (px >= tpPx) {
          return { tp_pct: tp, sl_pct: sl, pnl_pct: tp, exit_reason: 'TP_FULL' as const, exit_offset_min: i + 1 };
        }
      }
      const lastIdx = candles.length - 1;
      const pnl = (candles[lastIdx].close - entry) / entry;
      return { tp_pct: tp, sl_pct: sl, pnl_pct: pnl, exit_reason: 'TIME_LIMIT' as const, exit_offset_min: lastIdx + 1 };
    });
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
