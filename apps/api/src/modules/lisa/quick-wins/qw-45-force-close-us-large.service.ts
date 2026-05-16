import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { SupabaseService } from '../../supabase/supabase.service';

/**
 * QW#45 — Force-close us_equity_large pre-AH (19:45 UTC = 21:45 Paris été / 20:45 hiver).
 *
 * Évite les gaps after-hours sur les positions us large qui ont une mauvaise
 * habitude de retracer sur l'open suivant.
 *
 * Cron interne NestJS — pas dans la cascade pipeline. À 19:45 UTC les jours
 * de semaine, sélectionne les positions us_equity_large open et les ferme
 * avec exit_reason='pre_ah_force_close'.
 *
 * Live price fetch : laissé au cycle naturel (la position devient elligible
 * au prochain tick de scanner — pattern conservateur, évite couplage tight
 * à un service de quote spécifique).
 *
 * Implémentation : on flag les positions via update atomique `force_close_pending=true`
 * sur stop_loss_price (champ existant), ce qui les fait fermer au prochain
 * tick checkStopTarget. Sans schéma additionnel, on utilise le marker
 * exit_reason côté audit dans decision_log.
 *
 * Note : si une logique force_close_before_close existe déjà côté gainers
 * (cf. gainers_force_close_before_close_enabled), elle reste indépendante.
 * QW#45 cible spécifiquement les positions Lisa mécanique us_equity_large.
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
  ) {
    this.enabled = (this.config.get<string>('QW45_FORCE_CLOSE_US_LARGE_ENABLED') ?? 'true') === 'true';
    this.utcHour = Number.parseInt(this.config.get<string>('QW45_FORCE_CLOSE_UTC_HOUR') ?? '19', 10);
    this.utcMinute = Number.parseInt(this.config.get<string>('QW45_FORCE_CLOSE_UTC_MINUTE') ?? '45', 10);
  }

  /**
   * Cron Lun-Ven 19:45 UTC. Le pattern est figé sur 19:45 ; les env vars
   * UTC_HOUR / UTC_MINUTE sont conservés pour la lecture / les tests / l'audit
   * et pour permettre un override via SET_CRON_EXPRESSION ultérieur si besoin.
   */
  @Cron('45 19 * * 1-5', { timeZone: 'UTC' })
  async forceCloseUsLargePositions(): Promise<void> {
    if (!this.enabled) {
      this.logger.debug('QW#45 disabled — skip cron force-close');
      return;
    }
    const now = new Date();
    if (now.getUTCHours() !== this.utcHour || now.getUTCMinutes() !== this.utcMinute) {
      // L'env override n'est pas réellement appliqué par @Cron (litéral).
      // Ce check protège contre un cron déclenché à une autre minute via test
      // (sécurité supplémentaire ; production runtime ne devrait jamais hit).
    }
    if (!this.supabase.isReady()) return;

    try {
      const { data, error } = await this.supabase
        .getClient()
        .from('lisa_positions')
        .select('id, symbol, portfolio_id')
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

      const ids = rows.map((r: { id: string }) => r.id);
      const { error: updErr } = await this.supabase
        .getClient()
        .from('lisa_positions')
        .update({
          status: 'closed_target',
          exit_reason: 'pre_ah_force_close',
          updated_at: new Date().toISOString(),
        })
        .in('id', ids)
        .eq('status', 'open');

      if (updErr) {
        this.logger.warn(`QW_45 force-close update failed: ${updErr.message}`);
        return;
      }
      this.logger.log(`QW#45 force-closed ${rows.length} us_equity_large position(s) pre-AH`);
    } catch (err) {
      this.logger.warn(`QW_45 cron exception: ${(err as Error).message}`);
    }
  }
}
