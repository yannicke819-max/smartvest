/**
 * P19v (30/04/2026 09:00 UTC) — /admin/eodhd-status endpoint.
 *
 * Expose la vue authoritative + locale + auto-throttle state du quota EODHD
 * pour observability. Permet de vérifier sans flytl logs :
 *   - Combien de calls EODHD aujourd'hui (truth source = /api/user)
 *   - Combien projetés localement (per-endpoint breakdown)
 *   - Burn rate /min
 *   - ETA exhaustion en minutes
 *   - État des pause flags (env + auto-throttle 70/85/95/99/100 %)
 */

import { Controller, Get, Headers, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EodhdQuotaService } from '../lisa/services/eodhd-quota.service';

@Controller('admin/eodhd-status')
export class AdminEodhdStatusController {
  private readonly logger = new Logger(AdminEodhdStatusController.name);

  constructor(
    private readonly quotaService: EodhdQuotaService,
    private readonly config: ConfigService,
  ) {}

  @Get()
  async getStatus(@Headers('x-admin-token') providedToken: string | undefined) {
    this.assertAdmin(providedToken);
    // Refresh authoritative depuis /api/user (cache 60s interne)
    await this.quotaService.refreshAuth();
    return this.quotaService.getStatus();
  }

  private assertAdmin(providedToken: string | undefined): void {
    const expected = this.config.get<string>('ADMIN_TOKEN');
    if (!expected || expected.length === 0) {
      throw new HttpException(
        {
          message: 'Endpoint disabled (ADMIN_TOKEN not configured)',
          code: 'ADMIN_DISABLED',
        },
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
