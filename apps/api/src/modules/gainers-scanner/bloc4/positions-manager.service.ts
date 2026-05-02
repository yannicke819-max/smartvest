/**
 * BLOC 4 — Positions manager service (ADR-005 PR5).
 *
 * Orchestrateur NestJS qui :
 *   1. Ouvre une position depuis un signal BLOC 3 (computeInitialTpSl + INSERT)
 *   2. Applique les ticks prix via trailing-engine (state machine)
 *   3. Persiste les transitions dans gainers_position_events (append-only)
 *   4. Ferme la position et calcule le PnL final
 *
 * Pure logic est dans tp-sl.ts + trailing-engine.ts. Ce service gère
 * uniquement l'I/O Supabase et le decision_log audit.
 */

import { Injectable, Logger } from '@nestjs/common';
import { SupabaseService } from '../../supabase/supabase.service';
import { ExitReason, PositionState, EntryTriggerKind } from '../domain/gainers-enums';
import { computeInitialTpSl, TpSlConfig, DEFAULT_TP_SL_CONFIG } from './tp-sl';
import { applyTick, PositionSnapshot, TrailingConfig, DEFAULT_TRAILING_CONFIG } from './trailing-engine';

export interface OpenPositionInput {
  symbol: string;
  exchange: string;
  assetClass: 'equity' | 'crypto';
  triggerKind: EntryTriggerKind;
  entryPrice: number;
  pathEff: number;
  sizeUsd: number;
  entrySwingLow?: number | null;
  entryVwap?: number | null;
}

export interface PositionRow {
  id: string;
  symbol: string;
  exchange: string;
  assetClass: 'equity' | 'crypto';
  triggerKind: EntryTriggerKind;
  entryPrice: number;
  pathEff: number;
  entrySwingLow: number | null;
  entryVwap: number | null;
  sizeUsd: number;
  tpPrice: number;
  slPrice: number;
  tpPct: number;
  slPct: number;
  state: PositionState;
  trailingStopPrice: number | null;
  mfePrice: number;
  mfePct: number;
  exitPrice: number | null;
  exitAt: string | null;
  exitReason: ExitReason | null;
  realizedPnlUsd: number | null;
  realizedPnlPct: number | null;
  entryAt: string;
}

export interface PositionsManagerConfig {
  tpSl: TpSlConfig;
  trailing: TrailingConfig;
}

export const DEFAULT_POSITIONS_MANAGER_CONFIG: PositionsManagerConfig = {
  tpSl: DEFAULT_TP_SL_CONFIG,
  trailing: DEFAULT_TRAILING_CONFIG,
};

@Injectable()
export class PositionsManagerService {
  private readonly logger = new Logger(PositionsManagerService.name);

  constructor(private readonly supabase: SupabaseService) {}

  /** Ouvre une nouvelle position. Calcule TP/SL initial, persiste, log OPENED. */
  async openPosition(
    input: OpenPositionInput,
    cfg: PositionsManagerConfig = DEFAULT_POSITIONS_MANAGER_CONFIG,
  ): Promise<PositionRow | null> {
    const tpSl = computeInitialTpSl(
      { entryPrice: input.entryPrice, pathEff: input.pathEff, marketClass: input.assetClass },
      cfg.tpSl,
    );

    const insertPayload = {
      symbol: input.symbol,
      exchange: input.exchange,
      asset_class: input.assetClass,
      trigger_kind: input.triggerKind,
      entry_price: input.entryPrice,
      entry_path_eff: input.pathEff,
      entry_swing_low: input.entrySwingLow ?? null,
      entry_vwap: input.entryVwap ?? null,
      size_usd: input.sizeUsd,
      tp_price: tpSl.tpPrice,
      sl_price: tpSl.slPrice,
      tp_pct: tpSl.tpPct,
      sl_pct: tpSl.slPct,
      state: PositionState.OPEN,
      mfe_price: input.entryPrice,
      mfe_pct: 0,
    };

    const { data, error } = await this.supabase
      .getClient()
      .from('gainers_positions')
      .insert(insertPayload)
      .select('id, entry_at')
      .maybeSingle();

    if (error || !data) {
      this.logger.error(`openPosition ${input.symbol} failed: ${error?.message ?? 'no row'}`);
      return null;
    }

    await this.logEvent(data.id as string, 'OPENED', input.entryPrice, null, PositionState.OPEN, {
      tp_price: tpSl.tpPrice,
      sl_price: tpSl.slPrice,
      path_eff: input.pathEff,
    });

    return {
      id: data.id as string,
      symbol: input.symbol,
      exchange: input.exchange,
      assetClass: input.assetClass,
      triggerKind: input.triggerKind,
      entryPrice: input.entryPrice,
      pathEff: input.pathEff,
      entrySwingLow: input.entrySwingLow ?? null,
      entryVwap: input.entryVwap ?? null,
      sizeUsd: input.sizeUsd,
      tpPrice: tpSl.tpPrice,
      slPrice: tpSl.slPrice,
      tpPct: tpSl.tpPct,
      slPct: tpSl.slPct,
      state: PositionState.OPEN,
      trailingStopPrice: null,
      mfePrice: input.entryPrice,
      mfePct: 0,
      exitPrice: null,
      exitAt: null,
      exitReason: null,
      realizedPnlUsd: null,
      realizedPnlPct: null,
      entryAt: data.entry_at as string,
    };
  }

  /**
   * Applique un tick prix sur une position. Persiste les transitions
   * et la fermeture éventuelle.
   */
  async onTick(
    positionId: string,
    currentPrice: number,
    cfg: PositionsManagerConfig = DEFAULT_POSITIONS_MANAGER_CONFIG,
  ): Promise<{ exitReason: ExitReason | null; newState: PositionState }> {
    const position = await this.fetchPosition(positionId);
    if (!position || position.state === PositionState.CLOSED) {
      return { exitReason: null, newState: PositionState.CLOSED };
    }

    const snap: PositionSnapshot = {
      state: position.state,
      entryPrice: position.entryPrice,
      pathEff: position.pathEff,
      tpPrice: position.tpPrice,
      initialSlPrice: position.slPrice,
      currentStopPrice: position.trailingStopPrice ?? position.slPrice,
      mfePrice: position.mfePrice,
    };

    const result = applyTick({ position: snap, currentPrice }, cfg.trailing);

    // Persist updated state
    const updates: Record<string, unknown> = {
      state: result.newState,
      mfe_price: result.newMfePrice,
      mfe_pct: (result.newMfePrice - position.entryPrice) / position.entryPrice,
      trailing_stop_price:
        result.newState === PositionState.OPEN ? null : result.newStopPrice,
      updated_at: new Date().toISOString(),
    };

    if (result.exitReason) {
      updates.exit_price = currentPrice;
      updates.exit_at = new Date().toISOString();
      updates.exit_reason = result.exitReason;
      const pnlPct = (currentPrice - position.entryPrice) / position.entryPrice;
      updates.realized_pnl_pct = pnlPct;
      updates.realized_pnl_usd = position.sizeUsd * pnlPct;
    }

    const { error } = await this.supabase
      .getClient()
      .from('gainers_positions')
      .update(updates)
      .eq('id', positionId);

    if (error) {
      this.logger.error(`onTick update ${positionId} failed: ${error.message}`);
    }

    if (result.stateTransition) {
      const eventKind =
        result.stateTransition === 'TO_TRAILING_20'
          ? 'TRAILING_20_TRIGGERED'
          : 'TRAILING_50_TRIGGERED';
      await this.logEvent(
        positionId,
        eventKind,
        currentPrice,
        position.state,
        result.newState,
        { stop: result.newStopPrice, mfe: result.newMfePrice },
      );
    }

    if (result.exitReason) {
      await this.logEvent(
        positionId,
        result.exitReason as string,
        currentPrice,
        position.state,
        PositionState.CLOSED,
        {
          pnl_pct: (updates.realized_pnl_pct as number),
          pnl_usd: (updates.realized_pnl_usd as number),
          mfe_price: result.newMfePrice,
        },
      );
    }

    return { exitReason: result.exitReason, newState: result.newState };
  }

  /** Lit une position depuis la DB et la mappe vers PositionRow. */
  async fetchPosition(positionId: string): Promise<PositionRow | null> {
    const { data, error } = await this.supabase
      .getClient()
      .from('gainers_positions')
      .select('*')
      .eq('id', positionId)
      .maybeSingle();

    if (error || !data) return null;
    return mapRow(data);
  }

  /** Lit toutes les positions ouvertes (state ≠ CLOSED). */
  async fetchOpenPositions(): Promise<PositionRow[]> {
    const { data, error } = await this.supabase
      .getClient()
      .from('gainers_positions')
      .select('*')
      .neq('state', PositionState.CLOSED);
    if (error || !data) return [];
    return data.map(mapRow);
  }

  private async logEvent(
    positionId: string,
    eventKind: string,
    price: number,
    stateBefore: PositionState | null,
    stateAfter: PositionState,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const { error } = await this.supabase
      .getClient()
      .from('gainers_position_events')
      .insert({
        position_id: positionId,
        event_kind: eventKind,
        price,
        state_before: stateBefore,
        state_after: stateAfter,
        payload,
      });
    if (error) {
      this.logger.warn(`logEvent ${eventKind} ${positionId} failed: ${error.message}`);
    }
  }
}

function mapRow(row: any): PositionRow {
  return {
    id: row.id,
    symbol: row.symbol,
    exchange: row.exchange,
    assetClass: row.asset_class,
    triggerKind: row.trigger_kind as EntryTriggerKind,
    entryPrice: Number(row.entry_price),
    pathEff: Number(row.entry_path_eff),
    entrySwingLow: row.entry_swing_low !== null ? Number(row.entry_swing_low) : null,
    entryVwap: row.entry_vwap !== null ? Number(row.entry_vwap) : null,
    sizeUsd: Number(row.size_usd),
    tpPrice: Number(row.tp_price),
    slPrice: Number(row.sl_price),
    tpPct: Number(row.tp_pct),
    slPct: Number(row.sl_pct),
    state: row.state as PositionState,
    trailingStopPrice: row.trailing_stop_price !== null ? Number(row.trailing_stop_price) : null,
    mfePrice: Number(row.mfe_price),
    mfePct: Number(row.mfe_pct),
    exitPrice: row.exit_price !== null ? Number(row.exit_price) : null,
    exitAt: row.exit_at,
    exitReason: row.exit_reason as ExitReason | null,
    realizedPnlUsd: row.realized_pnl_usd !== null ? Number(row.realized_pnl_usd) : null,
    realizedPnlPct: row.realized_pnl_pct !== null ? Number(row.realized_pnl_pct) : null,
    entryAt: row.entry_at,
  };
}
