import { Controller, Get, Post, Param, Body, Query, HttpCode } from '@nestjs/common';
import { MacroService } from './services/macro.service';
import type { RawSignalInput } from './services/signal-normalizer.service';

@Controller()
export class MacroController {
  constructor(private readonly macro: MacroService) {}

  @Get('signals')
  listSignals(
    @Query('category') category?: string,
    @Query('severity') severity?: string,
    @Query('limit') limit?: string,
  ) {
    return this.macro.listSignals({
      ...(category !== undefined ? { category } : {}),
      ...(severity !== undefined ? { severity } : {}),
      ...(limit !== undefined ? { limit: parseInt(limit, 10) } : {}),
    });
  }

  @Post('signals/ingest')
  ingestSignal(@Body() dto: RawSignalInput) {
    return this.macro.ingestSignal(dto);
  }

  @Get('signals/watch')
  getWatchSignals() {
    return this.macro.getWatchSignals();
  }

  @Get('signals/:id')
  getSignal(@Param('id') id: string) {
    return this.macro.getSignal(id);
  }

  @Post('signals/:id/assess-impact')
  @HttpCode(200)
  assessImpact(
    @Param('id') id: string,
    @Body('portfolioId') portfolioId: string,
  ) {
    return this.macro.assessImpact(id, portfolioId);
  }

  @Post('signals/:id/find-analogs')
  @HttpCode(200)
  findAnalogs(@Param('id') id: string) {
    return this.macro.findAnalogs(id);
  }

  @Post('signals/:id/generate-conclusion')
  @HttpCode(200)
  generateConclusion(@Param('id') id: string) {
    return this.macro.generateConclusion(id);
  }

  @Get('portfolio/:id/signal-impact')
  getPortfolioSignalImpact(@Param('id') portfolioId: string) {
    return this.macro.getPortfolioSignalImpact(portfolioId);
  }

  @Get('portfolio/:id/market-context')
  getMarketContext(@Param('id') portfolioId: string) {
    return this.macro.getMarketContext(portfolioId);
  }

  @Post('signals/:id/convert-to-alert')
  @HttpCode(200)
  convertToAlert(
    @Param('id') id: string,
    @Body('portfolioId') portfolioId: string,
  ) {
    return this.macro.convertToAlert(id, portfolioId);
  }

  @Post('signals/:id/convert-to-simulation')
  @HttpCode(200)
  convertToSimulation(
    @Param('id') id: string,
    @Body('portfolioId') portfolioId: string,
  ) {
    return this.macro.convertToSimulation(id, portfolioId);
  }

  @Post('signals/:id/convert-to-suggestion')
  @HttpCode(200)
  convertToSuggestion(
    @Param('id') id: string,
    @Body('portfolioId') portfolioId: string,
  ) {
    return this.macro.convertToSuggestion(id, portfolioId);
  }
}
