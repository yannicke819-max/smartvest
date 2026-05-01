/**
 * GET /admin/gainers/scanner-status — observability read-only du scanner Gainers.
 *
 * Expose l'état diagnostique sans flyctl logs : quelle est la dernière raison
 * d'early-return, quels exchanges ont retourné quoi, état des kill-switches,
 * config courante des portfolios actifs, compteurs 24h.
 *
 * N'influence ni le scoring, ni les seuils, ni la logique d'open/close.
 *
 * Auth : header `x-admin-token` aligné sur le pattern AdminEodhdStatusController.
 */

import { Controller, Get, Headers, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TopGainersScannerService } from '../lisa/services/top-gainers-scanner.service';

@Controller('admin/gainers/scanner-status')
export class AdminGainersStatusController {
  private readonly logger = new Logger(AdminGainersStatusController.name);

  constructor(
    private readonly scanner: TopGainersScannerService,
    private readonly config: ConfigService,
  ) {}

  @Get()
  async getStatus(@Headers('x-admin-token') providedToken: string | undefined) {
    this.assertAdmin(providedToken);
    return this.scanner.getStatus();
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
