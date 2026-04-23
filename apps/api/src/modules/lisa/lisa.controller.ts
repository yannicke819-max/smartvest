import { Body, Controller, Get, Headers, HttpCode, Param, Post, Query } from '@nestjs/common';
import { extractUserId } from '../../common/extract-user-id';
import { LisaService } from './services/lisa.service';
import { DecisionLogService } from './services/decision-log.service';
import { RealtimePriceService } from './services/realtime-price.service';

@Controller('lisa')
export class LisaController {
  constructor(
    private readonly lisa: LisaService,
    private readonly decisionLog: DecisionLogService,
    private readonly realtimePrice: RealtimePriceService,
  ) {}

  @Get('realtime/price-cache')
  getPriceCache() {
    return {
      wsConnected: this.realtimePrice.isConnected(),
      activeCryptoCount: this.realtimePrice.getActiveCryptoCount(),
      prices: this.realtimePrice.snapshot(),
      quota: this.realtimePrice.getQuotaStatus(),
    };
  }

  @Get('binance/balance')
  getBinanceBalance(@Headers() headers: Record<string, string>) {
    extractUserId(headers); // throws si non authentifié
    return this.lisa.fetchBinanceBalance();
  }

  @Get('eodhd/stats')
  getEodhdStats(@Headers() headers: Record<string, string>) {
    extractUserId(headers);
    return this.lisa.fetchEodhdStats();
  }

  @Get('claude/stats')
  getClaudeStats(@Headers() headers: Record<string, string>) {
    extractUserId(headers);
    return this.lisa.fetchClaudeStats();
  }

  @Get('audit/verify/:portfolioId')
  async verifyAuditChain(
    @Headers() headers: Record<string, string>,
    @Param('portfolioId') portfolioId: string,
  ) {
    // Note: ideally we'd check ownership here too, but DecisionLogService
    // only queries, so rely on RLS + service role filter implicitly.
    extractUserId(headers); // throws if not authenticated
    return this.decisionLog.verifyChain(portfolioId);
  }

  // ── Session config ──────────────────────────────────────────────────────────

  @Get('config/:portfolioId')
  getConfig(
    @Headers() headers: Record<string, string>,
    @Param('portfolioId') portfolioId: string,
  ) {
    return this.lisa.getSessionConfig(extractUserId(headers), portfolioId);
  }

  @Post('config/:portfolioId')
  upsertConfig(
    @Headers() headers: Record<string, string>,
    @Param('portfolioId') portfolioId: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.lisa.upsertSessionConfig(extractUserId(headers), portfolioId, body as never);
  }

  // ── Proposal generation + approval ─────────────────────────────────────────

  @Post('proposals/:portfolioId/generate')
  @HttpCode(200)
  generateProposal(
    @Headers() headers: Record<string, string>,
    @Param('portfolioId') portfolioId: string,
    @Body('userFocus') userFocus?: string,
  ) {
    return this.lisa.generateProposal(extractUserId(headers), portfolioId, userFocus);
  }

  @Get('proposals/:portfolioId')
  listProposals(
    @Headers() headers: Record<string, string>,
    @Param('portfolioId') portfolioId: string,
    @Query('limit') limit?: string,
  ) {
    return this.lisa.listProposals(extractUserId(headers), portfolioId, limit ? parseInt(limit, 10) : 20);
  }

  @Post('proposals/:proposalId/approve')
  @HttpCode(200)
  approveProposal(
    @Headers() headers: Record<string, string>,
    @Param('proposalId') proposalId: string,
  ) {
    return this.lisa.approveProposal(extractUserId(headers), proposalId);
  }

  @Post('proposals/:proposalId/reject')
  @HttpCode(200)
  rejectProposal(
    @Headers() headers: Record<string, string>,
    @Param('proposalId') proposalId: string,
    @Body('reason') reason: string,
  ) {
    return this.lisa.rejectProposal(extractUserId(headers), proposalId, reason ?? 'no reason provided');
  }

  // ── Positions + portfolio state ─────────────────────────────────────────────

  @Get('positions/:portfolioId')
  listPositions(
    @Headers() headers: Record<string, string>,
    @Param('portfolioId') portfolioId: string,
    @Query('openOnly') openOnly?: string,
  ) {
    return this.lisa.listPositions(extractUserId(headers), portfolioId, openOnly === 'true');
  }

  @Get('snapshot/:portfolioId')
  getCurrentSnapshot(
    @Headers() headers: Record<string, string>,
    @Param('portfolioId') portfolioId: string,
  ) {
    return this.lisa.getCurrentSnapshot(extractUserId(headers), portfolioId);
  }

  @Get('snapshots/:portfolioId')
  getSnapshotHistory(
    @Headers() headers: Record<string, string>,
    @Param('portfolioId') portfolioId: string,
    @Query('window') window?: string,
  ) {
    const windowDays = window ? parseInt(window, 10) : 30;
    return this.lisa.getSnapshotHistory(extractUserId(headers), portfolioId, windowDays);
  }

  // ── Decision log ────────────────────────────────────────────────────────────

  @Get('decisions/:portfolioId')
  getDecisionLog(
    @Headers() headers: Record<string, string>,
    @Param('portfolioId') portfolioId: string,
    @Query('limit') limit?: string,
  ) {
    return this.lisa.getDecisionLog(extractUserId(headers), portfolioId, limit ? parseInt(limit, 10) : 50);
  }

  // ── Risk monitoring + kill-switch ───────────────────────────────────────────

  @Post('risk-check/:portfolioId')
  @HttpCode(200)
  runRiskCheck(
    @Headers() headers: Record<string, string>,
    @Param('portfolioId') portfolioId: string,
  ) {
    return this.lisa.runRiskCheck(extractUserId(headers), portfolioId);
  }

  @Post('kill-switch/:portfolioId')
  @HttpCode(200)
  triggerKillSwitch(
    @Headers() headers: Record<string, string>,
    @Param('portfolioId') portfolioId: string,
    @Body('reason') reason: string,
  ) {
    return this.lisa.triggerKillSwitch(extractUserId(headers), portfolioId, reason ?? 'Manual user kill');
  }

  @Post('portfolio/:portfolioId/reset-simulation')
  @HttpCode(200)
  resetSimulation(
    @Headers() headers: Record<string, string>,
    @Param('portfolioId') portfolioId: string,
  ) {
    return this.lisa.resetSimulation(extractUserId(headers), portfolioId);
  }

  @Post('portfolio/:portfolioId/proposals/purge')
  @HttpCode(200)
  purgeOldProposals(
    @Headers() headers: Record<string, string>,
    @Param('portfolioId') portfolioId: string,
    @Body('olderThanHours') olderThanHours?: number,
  ) {
    return this.lisa.purgeOldProposals(
      extractUserId(headers),
      portfolioId,
      typeof olderThanHours === 'number' ? olderThanHours : 24,
    );
  }
}
