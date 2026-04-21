import { Controller, Post, Get, Query, Headers, HttpCode, BadRequestException } from '@nestjs/common';
import { extractUserId } from '../../common/extract-user-id';
import { ProposalGeneratorService } from './services/proposal-generator.service';


@Controller('proposal-generator')
export class ProposalGeneratorController {
  constructor(private readonly generator: ProposalGeneratorService) {}

  /**
   * Manually trigger proposal generation for a portfolio.
   * In production this would be called by a scheduled job or event hook.
   * Returns the generation result (counts, not raw proposals).
   */
  @Post('generate')
  @HttpCode(200)
  generate(
    @Headers() headers: Record<string, string>,
    @Query('portfolioId') portfolioId: string,
  ) {
    if (!portfolioId) throw new BadRequestException('portfolioId is required');
    return this.generator.generateForPortfolio(portfolioId, extractUserId(headers));
  }

  /** Quick health check — returns config state without running generation */
  @Get('status')
  status() {
    return {
      module: 'proposal-generator',
      maxProposalsPerRun: 5,
      sources: ['drift', 'concentration', 'goal_trigger', 'macro_signal', 'performance'],
      note: 'Invoke POST /proposal-generator/generate?portfolioId=X to trigger generation.',
    };
  }
}
