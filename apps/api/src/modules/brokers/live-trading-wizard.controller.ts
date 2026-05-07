import { Body, Controller, Get, Headers, Param, Post } from '@nestjs/common';
import { LiveTradingWizardService } from './services/live-trading-wizard.service';
import { LiveFeatureFlagsService } from './services/live-feature-flags.service';
import { extractUserId } from '../../common/extract-user-id';

/**
 * PR Wizard.2 — Endpoints REST pour le LIVE Trading Wizard.
 *
 * Tous les endpoints :
 *   - Requièrent auth (extractUserId throws 401 si pas de token)
 *   - Ne touchent JAMAIS BROKER_EXECUTION_ENABLED hors via WizardService
 *   - Audit chaque appel via live_wizard_audit
 *
 * Routes :
 *   GET    /live-trading-wizard/:portfolioId           → état courant
 *   POST   /live-trading-wizard/:portfolioId/step1     → choix brokers
 *   POST   /live-trading-wizard/:portfolioId/step2     → validation credentials
 *   POST   /live-trading-wizard/:portfolioId/step3     → création mandate
 *   POST   /live-trading-wizard/:portfolioId/step4     → force sandbox result (admin)
 *   POST   /live-trading-wizard/:portfolioId/activate  → step 5 ACTIVATION LIVE
 *   POST   /live-trading-wizard/:portfolioId/revert    → revert LIVE → paper
 *   GET    /live-trading-wizard/flags/states           → status global flags DB+env
 */
@Controller('live-trading-wizard')
export class LiveTradingWizardController {
  constructor(
    private readonly wizard: LiveTradingWizardService,
    private readonly liveFlags: LiveFeatureFlagsService,
  ) {}

  @Get(':portfolioId')
  async getState(
    @Headers() headers: Record<string, string>,
    @Param('portfolioId') portfolioId: string,
  ) {
    const userId = extractUserId(headers);
    return this.wizard.getOrCreateWizardState(userId, portfolioId);
  }

  @Post(':portfolioId/step1')
  async step1(
    @Headers() headers: Record<string, string>,
    @Param('portfolioId') portfolioId: string,
    @Body() body: { use_ibkr: boolean; use_binance_us: boolean },
  ) {
    const userId = extractUserId(headers);
    return this.wizard.submitStep1(userId, portfolioId, body);
  }

  @Post(':portfolioId/step2')
  async step2(
    @Headers() headers: Record<string, string>,
    @Param('portfolioId') portfolioId: string,
    @Body() body: { ibkr_connection_id?: string; binance_connection_id?: string },
  ) {
    const userId = extractUserId(headers);
    return this.wizard.submitStep2(userId, portfolioId, body);
  }

  @Post(':portfolioId/step3')
  async step3(
    @Headers() headers: Record<string, string>,
    @Param('portfolioId') portfolioId: string,
    @Body() body: {
      max_position_size_pct: number;
      max_single_trade_pct: number;
      max_daily_trade_pct: number;
      allowed_asset_classes: string[];
      forbidden_tickers: string[];
      stop_loss_trigger_pct: number;
      expires_in_days: number;
      max_open_positions: number;
    },
  ) {
    const userId = extractUserId(headers);
    return this.wizard.submitStep3(userId, portfolioId, body);
  }

  @Post(':portfolioId/step4')
  async step4(
    @Headers() headers: Record<string, string>,
    @Param('portfolioId') portfolioId: string,
    @Body() body: { result: 'passed' | 'failed'; metrics: Record<string, unknown> },
  ) {
    const userId = extractUserId(headers);
    return this.wizard.forceStep4Result(userId, portfolioId, body.result, body.metrics);
  }

  @Post(':portfolioId/activate')
  async activate(
    @Headers() headers: Record<string, string>,
    @Param('portfolioId') portfolioId: string,
    @Body() body: { acknowledged: boolean },
  ) {
    const userId = extractUserId(headers);
    return this.wizard.activateLive(userId, portfolioId, body.acknowledged === true);
  }

  @Post(':portfolioId/revert')
  async revert(
    @Headers() headers: Record<string, string>,
    @Param('portfolioId') portfolioId: string,
    @Body() body: { reason: string },
  ) {
    const userId = extractUserId(headers);
    return this.wizard.revertToPaper(userId, portfolioId, body.reason || 'manual revert');
  }

  @Get('flags/states')
  async getFlagsStates(@Headers() headers: Record<string, string>) {
    extractUserId(headers); // auth check
    return { flags: await this.liveFlags.getAllStates() };
  }
}
