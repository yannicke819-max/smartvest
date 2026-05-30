/**
 * Endpoint admin pour DEBUG du scanner — test direct EODHD screener par exchange.
 *
 * Use case : pourquoi .T (Tokyo), .HK (Hong Kong), .MI (Milan), .BME, .AMS
 * ne remontent JAMAIS de candidat sur 3 semaines de scan ? Possible :
 *   - EODHD plan ne couvre pas ces exchanges
 *   - Filtre market_cap > 50M trop strict
 *   - Code exchange invalide (EODHD utilise un autre code)
 *
 * GET /admin/scanner-debug/test-screener?ex=T   → résultat brut EODHD pour TSE
 * GET /admin/scanner-debug/test-all-exchanges   → boucle sur les 18 exchanges
 */

import { Controller, Get, Headers, HttpException, HttpStatus, Logger, Query } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TopGainersScannerService } from '../lisa/services/top-gainers-scanner.service';

const ALL_EXCHANGES = [
  // EU
  'LSE', 'XETRA', 'PA', 'SW', 'MI', 'MC', 'BME', 'AS', 'AMS',
  // Non-EU
  'US', 'T', 'HK', 'AU', 'KO', 'KQ', 'TO', 'SHG', 'SHE',
  // Bonus à tester (non-déclarés actuellement)
  'NSE', 'BSE', 'V', 'CN', 'F', 'BR', 'IS', 'JK', 'KAR', 'OL', 'CO', 'TA', 'WAR',
];

@Controller('admin/scanner-debug')
export class AdminScannerDebugController {
  private readonly logger = new Logger(AdminScannerDebugController.name);

  constructor(
    private readonly scanner: TopGainersScannerService,
    private readonly config: ConfigService,
  ) {}

  @Get('test-screener')
  async testOne(
    @Headers('x-admin-token') providedToken: string | undefined,
    @Query('ex') ex?: string,
  ) {
    this.assertAdmin(providedToken);
    if (!ex) throw new HttpException('?ex=<exchange> required', HttpStatus.BAD_REQUEST);
    return this.scanner.debugScreener(ex);
  }

  @Get('test-all-exchanges')
  async testAll(@Headers('x-admin-token') providedToken: string | undefined) {
    this.assertAdmin(providedToken);
    const results: Array<{ exchange: string; candidates_count: number; error?: string; sample_symbols?: string[] }> = [];
    // Test sequentially to avoid hammering EODHD
    for (const ex of ALL_EXCHANGES) {
      const r = await this.scanner.debugScreener(ex);
      results.push({
        exchange: ex,
        candidates_count: r.candidates_count,
        ...(r.error ? { error: r.error } : {}),
        sample_symbols: r.sample.slice(0, 3).map((c) => c.symbol),
      });
    }
    // Sort by count desc to identify quickly empty ones
    results.sort((a, b) => b.candidates_count - a.candidates_count);
    return {
      tested_at: new Date().toISOString(),
      total_exchanges_tested: results.length,
      working: results.filter((r) => r.candidates_count > 0).length,
      empty: results.filter((r) => r.candidates_count === 0 && !r.error).length,
      errored: results.filter((r) => !!r.error).length,
      results,
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
