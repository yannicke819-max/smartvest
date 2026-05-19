/**
 * PR #356 (19/05/2026) — /admin/providers-status endpoint.
 *
 * Diagnostic en 1 curl post-deploy de l'état DI du IntradayProviderRouter :
 *   - td_injected   : TwelveDataService bien câblé ?
 *   - blacklist_injected : TickerBlacklistService bien câblé ?
 *   - enabled       : flag TWELVEDATA_INTRADAY_SCANNER_ENABLED actif ?
 *   - ratio         : valeur effective TWELVEDATA_INTRADAY_AB_TEST_RATIO
 *   - flag_raw      : valeur brute du flag (debug typos)
 *   - td_apikey_set : TwelveDataService a bien sa clé API ?
 *
 * Symptôme historique (v569) : 100% des appels router avec
 * td_skip_reason="td_not_injected" alors que TwelveDataService logge
 * apiKey=set au boot. Cet endpoint permet de confirmer le fix PR #356
 * post-deploy v570.
 *
 * Auth : header `x-admin-token` (même secret que /admin/eodhd-status).
 */

import { Controller, Get, Headers, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IntradayProviderRouter } from '../lisa/services/intraday-provider-router.service';

@Controller('admin/providers-status')
export class AdminProvidersStatusController {
  private readonly logger = new Logger(AdminProvidersStatusController.name);

  constructor(
    private readonly router: IntradayProviderRouter,
    private readonly config: ConfigService,
  ) {}

  @Get()
  async getStatus(@Headers('x-admin-token') providedToken: string | undefined) {
    this.assertAdmin(providedToken);

    const routerStatus = this.router.getInjectionStatus();
    const tdApiKey = this.config.get<string>('TWELVEDATA_API_KEY');
    const apikeySet = !!tdApiKey && tdApiKey.trim().length > 0;
    const apikeyTail = apikeySet && tdApiKey ? tdApiKey.slice(-4) : null;

    return {
      router: routerStatus,
      td_service: {
        apikey_set: apikeySet,
        apikey_tail: apikeyTail,
        apikey_length: tdApiKey ? tdApiKey.length : 0,
      },
      env: {
        scanner_enabled: this.config.get<string>('TWELVEDATA_INTRADAY_SCANNER_ENABLED'),
        ab_test_ratio: this.config.get<string>('TWELVEDATA_INTRADAY_AB_TEST_RATIO'),
        ab_ratio_legacy_fossil: this.config.get<string>('TWELVEDATA_INTRADAY_AB_RATIO'),
        per_minute_limit: this.config.get<string>('TWELVEDATA_PER_MINUTE_LIMIT'),
        per_day_limit: this.config.get<string>('TWELVEDATA_PER_DAY_LIMIT'),
      },
      verdict: this.computeVerdict(routerStatus, apikeySet),
    };
  }

  private computeVerdict(
    routerStatus: { td_injected: boolean; blacklist_injected: boolean; enabled: boolean; ratio: number },
    apikeySet: boolean,
  ): { status: 'OK' | 'KO'; reasons: string[] } {
    const reasons: string[] = [];
    if (!routerStatus.td_injected) reasons.push('td_not_injected');
    if (!routerStatus.blacklist_injected) reasons.push('blacklist_not_injected');
    if (!apikeySet) reasons.push('td_apikey_missing');
    if (!routerStatus.enabled) reasons.push('flag_off');
    if (routerStatus.ratio <= 0) reasons.push('ratio_zero');
    return {
      status: reasons.length === 0 ? 'OK' : 'KO',
      reasons,
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
