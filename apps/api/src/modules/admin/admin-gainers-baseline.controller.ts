/**
 * POST /admin/gainers/baseline/refresh — déclenchement manuel ETL baseline volume.
 *
 * Bootstrap pour PR5 BLOC 4.0 : permet à l'opérateur de peupler
 * gainers_volume_baselines sans attendre le cron 01:00 UTC. Idempotent
 * (onConflict='symbol,exchange'), safe à re-run.
 *
 * Auth : header `x-admin-token` aligné sur le pattern AdminGainersStatusController.
 *
 * Réponse :
 * {
 *   totalSymbols: 215,
 *   computed: 213,
 *   cacheHits: 198,
 *   cacheMisses: 12,
 *   liveFetchSuccess: 14,
 *   liveFetchFailures: 1,
 *   cacheStale: false,
 *   durationMs: 8523
 * }
 */

import { Controller, HttpException, HttpStatus, Logger, Post, Headers } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { VolumeBaselineCalculatorService } from '../gainers-scanner/bloc2/volume-baseline-calculator.service';
import { VolumeBaselineService } from '../gainers-scanner/bloc2/volume-baseline.service';

@Controller('admin/gainers/baseline')
export class AdminGainersBaselineController {
  private readonly logger = new Logger(AdminGainersBaselineController.name);

  constructor(
    private readonly calculator: VolumeBaselineCalculatorService,
    private readonly baseline: VolumeBaselineService,
    private readonly config: ConfigService,
  ) {}

  @Post('refresh')
  async refresh(@Headers('x-admin-token') providedToken: string | undefined) {
    this.assertAdmin(providedToken);
    this.logger.log('[admin] baseline ETL refresh triggered manually');
    const result = await this.calculator.runEtl();
    // Recharge le cache mémoire après l'upsert pour que le scanner voie
    // immédiatement les nouvelles baselines.
    await this.baseline.reloadCache();
    return {
      ...result,
      cacheReloaded: true,
      cacheSize: this.baseline.cacheSize,
    };
  }

  private assertAdmin(providedToken: string | undefined): void {
    const expected = this.config.get<string>('ADMIN_TOKEN');
    if (!expected || expected.length === 0) {
      throw new HttpException(
        { message: 'Endpoint disabled (ADMIN_TOKEN not configured)', code: 'ADMIN_DISABLED' },
        HttpStatus.FORBIDDEN,
      );
    }
    if (providedToken !== expected) {
      throw new HttpException(
        { message: 'Invalid admin token', code: 'ADMIN_FORBIDDEN' },
        HttpStatus.FORBIDDEN,
      );
    }
  }
}
