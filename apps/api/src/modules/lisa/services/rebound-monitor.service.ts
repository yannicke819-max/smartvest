/**
 * P3-A — Cron monitor pour rebound_positions.
 *
 * Tourne toutes les 5 minutes. Pour chaque position OPEN :
 *   1. Fetch prix live (LisaService.getLivePrice).
 *   2. Évalue la sortie palier le plus haut atteint depuis la dernière
 *      évaluation (TP3 > TP2 > TP1) ou SL ou time stop.
 *   3. Update status, filled_qty_pct, realized_pnl_usd dans Supabase.
 *
 * Ne déclenche AUCUN ordre réel — c'est un monitor de simulation /
 * paper trading. La sortie réelle (broker) sera ajoutée plus tard
 * via le chemin `BrokerAdapter` standard sous `AUTONOMOUS_GUARDED`.
 */

import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { SupabaseService } from '../../supabase/supabase.service';
import { LisaService } from './lisa.service';

interface ReboundPositionRow {
  id: string;
  portfolio_id: string;
  ticker: string;
  entry_price: string;
  entry_at: string;
  tp1: string;
  tp2: string;
  tp3: string;
  sl: string;
  time_stop_at: string;
  status: 'OPEN' | 'TP1_HIT' | 'TP2_HIT' | 'TP3_HIT' | 'SL_HIT' | 'TIMEOUT' | 'CLOSED';
  filled_qty_pct: string;
  realized_pnl_usd: string;
}

const QTY_TP1_PCT = 50;
const QTY_TP2_PCT = 30;
const QTY_TP3_PCT = 20;

@Injectable()
export class ReboundMonitorService {
  private readonly logger = new Logger(ReboundMonitorService.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly lisa: LisaService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Cron toutes les 5 minutes. Évalue les sorties pour toutes les
   * positions rebound OPEN.
   */
  @Cron(CronExpression.EVERY_5_MINUTES, { name: 'rebound-monitor' })
  async runMonitor(): Promise<void> {
    try {
      await this.runMonitorInner();
    } catch (e) {
      this.logger.error(`[rebound-monitor] cycle failed: ${String(e).slice(0, 200)}`);
    }
  }

  private async runMonitorInner(): Promise<void> {
    const { data: positions, error } = await this.supabase
      .getClient()
      .from('rebound_positions')
      .select('*')
      .eq('status', 'OPEN');

    if (error) {
      this.logger.error(`[rebound-monitor] fetch failed: ${error.message}`);
      return;
    }
    if (!positions || positions.length === 0) return;

    this.logger.log(`[rebound-monitor] evaluating ${positions.length} OPEN position(s)`);

    for (const raw of positions as ReboundPositionRow[]) {
      try {
        await this.evaluatePosition(raw);
      } catch (e) {
        this.logger.warn(
          `[rebound-monitor] eval failed for ${raw.ticker} (${raw.id.slice(0, 8)}): ${String(e).slice(0, 120)}`,
        );
      }
    }
  }

  private async evaluatePosition(row: ReboundPositionRow): Promise<void> {
    const entry = parseFloat(row.entry_price);
    const tp1 = parseFloat(row.tp1);
    const tp2 = parseFloat(row.tp2);
    const tp3 = parseFloat(row.tp3);
    const sl = parseFloat(row.sl);
    const filledQtyPct = parseFloat(row.filled_qty_pct);
    const currentPnl = parseFloat(row.realized_pnl_usd);

    // Time stop : prioritaire, indépendant du prix.
    const now = Date.now();
    const stopAt = new Date(row.time_stop_at).getTime();
    if (now >= stopAt) {
      await this.closePosition(row.id, 'TIMEOUT', filledQtyPct, entry, currentPnl, entry);
      this.logger.log(
        `[rebound-monitor] ${row.ticker} TIMEOUT (time stop ${row.time_stop_at}) — close ${filledQtyPct}% remaining`,
      );
      return;
    }

    // Fetch prix live. Si fallback / fallback_unknown → skip ce cycle
    // pour ne pas trigger des sorties sur prix corrompus (cf. CLAUDE.md
    // section "Garde-fous prix fallback").
    const live = await this.lisa.getLivePrice(row.ticker).catch(() => null);
    if (!live) {
      this.logger.warn(`[rebound-monitor] ${row.ticker}: getLivePrice failed — skip cycle`);
      return;
    }
    if (this.isFallbackSource(live.source)) {
      this.logger.warn(
        `[rebound-monitor] ${row.ticker}: source=${live.source} (fallback) — skip cycle`,
      );
      return;
    }
    const price = parseFloat(live.price);
    if (!Number.isFinite(price) || price <= 0) {
      this.logger.warn(`[rebound-monitor] ${row.ticker}: invalid price ${live.price} — skip`);
      return;
    }

    // SL check : prioritaire sur TP. Close totalement.
    if (price <= sl) {
      const closeQtyPct = filledQtyPct;
      const pnlAdd = ((sl - entry) / entry) * closeQtyPct; // approx pnl en %
      await this.closePosition(row.id, 'SL_HIT', closeQtyPct, sl, currentPnl, entry);
      this.logger.warn(
        `[rebound-monitor] ${row.ticker} SL_HIT @${price.toFixed(2)} (sl=${sl.toFixed(2)}, pnlPct≈${pnlAdd.toFixed(2)})`,
      );
      return;
    }

    // TP cascade : on teste du palier le plus haut au plus bas.
    let exitQtyPct = 0;
    let newStatus: ReboundPositionRow['status'] | null = null;
    let exitPrice = 0;

    if (price >= tp3 && row.status === 'OPEN') {
      // Cas où on saute directement à TP3 (gap up)
      exitQtyPct = filledQtyPct;
      newStatus = 'TP3_HIT';
      exitPrice = tp3;
    } else if (price >= tp3) {
      exitQtyPct = filledQtyPct;
      newStatus = 'TP3_HIT';
      exitPrice = tp3;
    } else if (price >= tp2 && row.status !== 'TP2_HIT' && row.status !== 'TP3_HIT') {
      exitQtyPct = QTY_TP2_PCT;
      newStatus = 'TP2_HIT';
      exitPrice = tp2;
    } else if (price >= tp1 && row.status === 'OPEN') {
      exitQtyPct = QTY_TP1_PCT;
      newStatus = 'TP1_HIT';
      exitPrice = tp1;
    }

    if (newStatus && exitQtyPct > 0) {
      const remaining = Math.max(0, filledQtyPct - exitQtyPct);
      // Approximation du P&L en % (le cron ne connaît pas la qty USD,
      // il stocke le P&L pct cumulatif comme proxy. Le service caller
      // qui open la position peut renormaliser avec le notionnel réel).
      const pnlAddPct = ((exitPrice - entry) / entry) * exitQtyPct;
      const newPnl = currentPnl + pnlAddPct;
      await this.closePosition(
        row.id,
        newStatus === 'TP3_HIT' ? 'TP3_HIT' : newStatus,
        remaining,
        exitPrice,
        newPnl,
        entry,
        remaining === 0,
      );
      this.logger.log(
        `[rebound-monitor] ${row.ticker} ${newStatus} @${price.toFixed(2)} → exit ${exitQtyPct}%, remaining ${remaining}%`,
      );
    }
  }

  private async closePosition(
    id: string,
    status: ReboundPositionRow['status'],
    remainingQtyPct: number,
    exitPrice: number,
    newPnlPct: number,
    _entry: number,
    finalize: boolean = true,
  ): Promise<void> {
    const updates: Record<string, unknown> = {
      status,
      filled_qty_pct: remainingQtyPct.toFixed(2),
      realized_pnl_usd: newPnlPct.toFixed(6),
    };
    if (finalize && remainingQtyPct === 0) {
      updates['closed_at'] = new Date().toISOString();
      // Override status with 'CLOSED' if all quantity exited (all TP hit)
      if (status === 'TP3_HIT' || status === 'SL_HIT' || status === 'TIMEOUT') {
        // Keep specific status (TP3_HIT/SL_HIT/TIMEOUT) for audit
      }
    }
    // Bug #314 m3 — UPDATE atomique avec garde de statut. Race interne
    // improbable (cron unique 5min) mais on borne l'UPDATE aux statuts
    // non-terminaux pour ne jamais écraser une position déjà CLOSED /
    // TP3_HIT / SL_HIT / TIMEOUT. Pattern aligné sur paper-broker:611-622.
    const { data: updated, error } = await this.supabase
      .getClient()
      .from('rebound_positions')
      .update(updates)
      .eq('id', id)
      .in('status', ['OPEN', 'TP1_HIT', 'TP2_HIT'])
      .select('id');
    if (error) {
      this.logger.error(`[rebound-monitor] update ${id} failed: ${error.message}`);
    } else if (!updated || updated.length === 0) {
      this.logger.warn(
        `[rebound-monitor] closePosition ${id} race detected — already in terminal status, skipping`,
      );
    }
    void exitPrice; // tagué pour audit futur (column exit_price si on l'ajoute)
  }

  /**
   * Détecte les sources fallback (cascade complètement échouée → prix
   * hardcoded ou inconnu). Cf. CLAUDE.md "Garde-fous prix fallback".
   */
  private isFallbackSource(source: string): boolean {
    if (!source) return true;
    return source.startsWith('fallback');
  }
}
