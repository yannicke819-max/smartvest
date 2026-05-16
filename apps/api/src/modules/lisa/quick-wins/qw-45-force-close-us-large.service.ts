import { forwardRef, Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { SupabaseService } from '../../supabase/supabase.service';
import { MechanicalTradingService } from '../services/mechanical-trading.service';

/**
 * QW#45 — Force-close us_equity_large pre-AH (19:45 UTC = 21:45 Paris été / 20:45 hiver).
 *
 * Évite les gaps after-hours sur les positions us large qui ont une mauvaise
 * habitude de retracer sur l'open suivant.
 *
 * Cron interne NestJS — pas dans la cascade pipeline. À 19:45 UTC les jours
 * de semaine, sélectionne les positions us_equity_large open et délègue chaque
 * fermeture à MechanicalTradingService.forceClosePosition().
 *
 * La délégation à forceClosePosition garantit (vs un UPDATE direct) :
 *  - fetch livePrice + skip si fallback / prix <= 0
 *  - calcul fees IBKR Pro + slippage 5 bps via computeRealisticFee
 *  - sanity R5 (exit_price ratio, pnl_pct guard)
 *  - guard MIN_NET_PROFIT_USD (ne matérialise pas un fake-TP)
 *  - UPDATE atomique double-clause + race detection
 *  - tradeOutcomeRecorder fire-and-forget
 *
 * Distinction analytics : status='closed_target' (pour matérialiser le PnL
 * via le pipeline standard) + exit_reason='pre_ah_force_close' (pour filtrer
 * dans le reporting "vrais TP" vs "force-close pré-AH").
 */
@Injectable()
export class Qw45ForceCloseUsLargeService {
  private readonly logger = new Logger(Qw45ForceCloseUsLargeService.name);
  private readonly enabled: boolean;
  private readonly utcHour: number;
  private readonly utcMinute: number;

  constructor(
    private readonly config: ConfigService,
    private readonly supabase: SupabaseService,
    // forwardRef pour casser le cycle DI : MechanicalTradingService transite par
    // LisaService → ... → re-touche un provider du même module à l'init.
    // Sans forwardRef, Nest reçoit undefined à l'index [2] et l'app crashe au boot
    // (production crash loop observé sur PR #332). Le forwardRef diffère la
    // résolution jusqu'au premier appel runtime, ce qui suffit (le cron @Cron
    // ne tire forceClosePosition qu'à 19:45 UTC en Lun-Ven).
    @Inject(forwardRef(() => MechanicalTradingService))
    private readonly mechanicalTrading: MechanicalTradingService,
  ) {
    this.enabled = (this.config.get<string>('QW45_FORCE_CLOSE_US_LARGE_ENABLED') ?? 'true') === 'true';
    this.utcHour = Number.parseInt(this.config.get<string>('QW45_FORCE_CLOSE_UTC_HOUR') ?? '19', 10);
    this.utcMinute = Number.parseInt(this.config.get<string>('QW45_FORCE_CLOSE_UTC_MINUTE') ?? '45', 10);
  }

  /**
   * Cron Lun-Ven 19:45 UTC. Le pattern est figé par décorateur ; les env vars
   * UTC_HOUR / UTC_MINUTE sont conservés pour la lecture / les tests / l'audit.
   */
  @Cron('45 19 * * 1-5', { timeZone: 'UTC' })
  async forceCloseUsLargePositions(): Promise<void> {
    if (!this.enabled) {
      this.logger.debug('QW#45 disabled — skip cron force-close');
      return;
    }
    if (!this.supabase.isReady()) return;

    try {
      const { data, error } = await this.supabase
        .getClient()
        .from('lisa_positions')
        .select('id, symbol')
        .eq('asset_class', 'us_equity_large')
        .eq('status', 'open')
        .limit(500);

      if (error) {
        this.logger.warn(`QW_45 select open us_large failed: ${error.message}`);
        return;
      }
      const rows = data ?? [];
      if (rows.length === 0) {
        this.logger.log('QW#45 cron : 0 us_equity_large open at pre-AH');
        return;
      }

      this.logger.log(`QW#45 force-closing ${rows.length} us_equity_large position(s) pre-AH...`);
      let success = 0;
      let skipped = 0;
      for (const row of rows) {
        try {
          await this.mechanicalTrading.forceClosePosition(row.id, 'pre_ah_force_close');
          success += 1;
        } catch (err) {
          skipped += 1;
          this.logger.warn(
            `QW_45 force-close ${row.symbol} (${row.id}) failed: ${(err as Error).message}`,
          );
        }
      }
      this.logger.log(`QW#45 cron done : ${success} closed, ${skipped} skipped/failed`);
    } catch (err) {
      this.logger.warn(`QW_45 cron exception: ${(err as Error).message}`);
    }
  }
}
